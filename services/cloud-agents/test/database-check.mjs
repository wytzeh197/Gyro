// Creates its own disposable Postgres cluster. No connection string, hosted
// project, production credential, or existing database is accepted.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync, spawn } from "node:child_process";
import assert from "node:assert/strict";
const bin = process.env.PG_BIN ?? "/opt/homebrew/opt/postgresql@17/bin";
const dir = mkdtempSync(join(tmpdir(), "gyro-cloud-db-test-"));
const data = join(dir, "data"),
  socket = dir;
function run(cmd, args, input) {
  const result = spawnSync(join(bin, cmd), args, { input, encoding: "utf8" });
  if (result.status !== 0) throw Error(`${cmd}: ${result.stderr}`);
  return result.stdout.trim();
}
const psql = [
  "-h",
  socket,
  "-d",
  "postgres",
  "-X",
  "-qAt",
  "-v",
  "ON_ERROR_STOP=1",
];
const sql = (query) => run("psql", psql, query);
const owner = "11111111-1111-4111-8111-111111111111",
  other = "22222222-2222-4222-8222-222222222222",
  concurrent = "33333333-3333-4333-8333-333333333333";
const runId = "44444444-4444-4444-8444-444444444444";
const config = (id) => ({
  id,
  repo: "https://github.com/example/repo.git",
  branch: "main",
  result_branch: `gyro/cloud/${id}`,
  task: "test",
  provider: "codex",
  model: null,
  cap_seconds: 60,
  idle_seconds: 600,
});
const rpc = (action, user, id = null, payload = {}) =>
  `select public.cloud_agents_rpc('${action}','${user}',${id ? `'${id}'` : "null"},'${JSON.stringify(payload)}');`;
const call = (...args) =>
  JSON.parse(sql(`set role service_role; ${rpc(...args)}`));
const topup = (user, seconds, reference) =>
  call("topup", user, null, { seconds, reference });
let started = false;
try {
  run("initdb", ["-D", data, "-A", "trust", "--locale=C", "-E", "UTF8"]);
  run("pg_ctl", [
    "-D",
    data,
    "-l",
    join(dir, "server.log"),
    "-o",
    `-h '' -k ${socket}`,
    "-w",
    "start",
  ]);
  started = true;
  sql(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as 'select nullif(current_setting(''request.jwt.claim.sub'',true),'''')::uuid';
    grant usage on schema auth to authenticated, service_role;
    insert into auth.users values ('${owner}'),('${other}'),('${concurrent}');`);
  sql(
    readFileSync(
      new URL(
        "../supabase/migrations/20261116094535_cloud_agents.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.equal(
    sql(
      "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='cloud_agents' and c.relkind='r' and c.relrowsecurity and c.relforcerowsecurity;",
    ),
    "5",
  );
  assert.equal(call("reserve", owner, runId, config(runId)).error, "disabled");
  sql("update cloud_agents.control set enabled=true;");
  assert.equal(
    call("reserve", owner, runId, config(runId)).error,
    "insufficient_hours",
  );
  topup(owner, 90, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  topup(owner, 90, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  assert.equal(
    call("balance", owner).seconds,
    90,
    "manual topup retry must not double-credit",
  );
  call("reserve", owner, runId, config(runId));
  call("reserve", owner, runId, config(runId));
  assert.equal(
    call("balance", owner).reserved_seconds,
    60,
    "start retry must not double-reserve",
  );
  assert.equal(
    call("reserve", owner, runId, { ...config(runId), task: "different" })
      .error,
    "conflict",
  );
  assert.equal(call("get", other, runId).error, "not_found");
  assert.equal(
    sql(
      `set role authenticated; set request.jwt.claim.sub='${other}'; select count(*) from cloud_agents.cloud_runs;`,
    ),
    "0",
  );
  assert.equal(
    sql(
      `set role authenticated; set request.jwt.claim.sub='${owner}'; select count(*) from cloud_agents.cloud_runs;`,
    ),
    "1",
  );
  assert.equal(
    sql(
      "select has_function_privilege('authenticated','public.cloud_agents_rpc(text,uuid,uuid,jsonb)','execute');",
    ),
    "f",
  );
  assert.equal(
    sql(
      "select has_function_privilege('anon','public.cloud_agents_rpc(text,uuid,uuid,jsonb)','execute');",
    ),
    "f",
  );
  assert.equal(
    sql(
      "select has_table_privilege('authenticated','cloud_agents.hour_balance','update');",
    ),
    "f",
  );
  call("activate", owner, runId);
  sql(
    `update cloud_agents.cloud_runs set activated_at=now()-interval '10 seconds' where id='${runId}';`,
  );
  const settled = call("settle", owner, runId, {
    segment: 1,
    status: "waiting",
    reason: "manual_pause",
    ended_at: new Date().toISOString(),
  });
  assert.ok(settled.used_seconds >= 9 && settled.used_seconds <= 12);
  const before = call("balance", owner);
  call("settle", owner, runId, {
    segment: 1,
    status: "waiting",
    reason: "manual_pause",
  });
  assert.deepEqual(
    call("balance", owner),
    before,
    "settlement retry must not charge twice",
  );
  const resumed = call("resume", owner, runId);
  assert.equal(resumed.segment, 2);
  assert.equal(resumed.reserved_seconds, 60 - settled.used_seconds);
  call("resume", owner, runId);
  assert.equal(
    call("balance", owner).reserved_seconds,
    resumed.reserved_seconds,
  );
  call("settle", owner, runId, {
    segment: 2,
    status: "cancelled",
    reason: "user_stop",
  });
  assert.equal(call("balance", owner).reserved_seconds, 0);
  assert.equal(
    sql(
      `select count(*) from cloud_agents.usage_ledger where run_id='${runId}';`,
    ),
    "6",
  );
  assert.equal(
    sql(
      "select has_table_privilege('service_role','cloud_agents.usage_ledger','update');",
    ),
    "f",
  );
  topup(concurrent, 90, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  const reserve = (id) =>
    new Promise((resolve, reject) => {
      const proc = spawn(join(bin, "psql"), psql, {
        stdio: ["pipe", "pipe", "pipe"],
      });
      let out = "",
        err = "";
      proc.stdout.on("data", (d) => (out += d));
      proc.stderr.on("data", (d) => (err += d));
      proc.on("error", reject);
      proc.on("exit", (code) =>
        code ? reject(Error(err)) : resolve(JSON.parse(out.trim())),
      );
      proc.stdin.end(
        `set role service_role; ${rpc("reserve", concurrent, id, config(id))}`,
      );
    });
  const results = await Promise.all([
    reserve("55555555-5555-4555-8555-555555555555"),
    reserve("66666666-6666-4666-8666-666666666666"),
  ]);
  assert.equal(results.filter((x) => x.status === "queued").length, 1);
  assert.equal(
    results.filter((x) => x.error === "insufficient_hours").length,
    1,
  );
  assert.equal(call("balance", concurrent).reserved_seconds, 60);
  sql("update cloud_agents.control set enabled=false;");
  assert.equal(call("control", owner).enabled, false);
  assert.equal(
    call(
      "reserve",
      owner,
      "77777777-7777-4777-8777-777777777777",
      config("77777777-7777-4777-8777-777777777777"),
    ).error,
    "disabled",
  );
  console.log(
    "Passed: migration, 5-table RLS, owner isolation, denied client writes/RPC, zero balance, idempotent credits/reservations/settlement, pause/resume, concurrent overspend prevention, kill switch.",
  );
} finally {
  if (started) run("pg_ctl", ["-D", data, "-m", "immediate", "-w", "stop"]);
  rmSync(dir, { recursive: true, force: true });
}
