import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import assert from "node:assert/strict";
const bundle = "/private/tmp/gyro-cloud-agents-worker-bundle";
const worker = {
  name: "prototype",
  scriptPath: `${bundle}/index.js`,
  modulesRoot: bundle,
  modules: true,
  compatibilityDate: "2026-11-16",
  compatibilityFlags: ["nodejs_compat"],
  durableObjects: { RUNS: { className: "CloudRun", useSQLite: true } },
  bindings: { GYRO_CLOUD_ENABLED: "0", CLOUD_AGENTS_ENABLED: "0" },
};
const mf = new Miniflare(convertV4MiniflareOptions(worker));
try {
  assert.equal(
    (await mf.dispatchFetch("https://prototype.test/v1/cloud/runs")).status,
    404,
  );
  await mf.setOptions(
    convertV4MiniflareOptions({
      ...worker,
      bindings: {
        GYRO_CLOUD_ENABLED: "1",
        CLOUD_AGENTS_ENABLED: "1",
        CLOUD_AGENTS_USER_IDS: "",
      },
    }),
  );
  assert.equal(
    (await mf.dispatchFetch("https://prototype.test/v1/cloud/runs")).status,
    401,
  );
  const { RUNS } = await mf.getBindings();
  const stub = RUNS.getByName("22222222-2222-4222-8222-222222222222");
  const run = {
    id: "22222222-2222-4222-8222-222222222222",
    user_id: "owner",
    status: "queued",
  };
  await stub.initialize("owner", run, {
    iv: "test-only",
    data: "encrypted-test-placeholder",
  });
  assert.equal((await stub.logs("owner", 0)).cursor, 0);
  await assert.rejects(stub.logs("outsider", 0));
  console.log(
    "Worker runtime passed: 404/401 boundaries; durable initialization/RPC, own logs and foreign-owner denial. No container started.",
  );
} finally {
  await mf.dispose();
}
