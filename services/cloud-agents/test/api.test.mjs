import test from "node:test";
import assert from "node:assert/strict";
import { handleAPI } from "../src/api.mjs";
import { authenticate } from "../src/database.mjs";
import {
  startInput,
  seal,
  unseal,
  redact,
  checkedPushBody,
} from "../src/safety.mjs";

const uid = "11111111-1111-4111-8111-111111111111";
const id = "22222222-2222-4222-8222-222222222222";
const key = btoa("e".repeat(32));
const env = {
  GYRO_CLOUD_ENABLED: "1",
  CLOUD_AGENTS_ENABLED: "1",
  CLOUD_AGENTS_USER_IDS: uid,
  CLOUD_AGENTS_ENCRYPTION_KEY: key,
  SUPABASE_URL: "https://test.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "test",
};
const credentials = {
  apiKey: "sk-ant-api-" + "a".repeat(30),
  gitToken: "github_pat_" + "b".repeat(30),
};
const input = {
  repo: "https://github.com/example/repo",
  branch: "main",
  task: "Add a test",
  provider: "claude",
  credentials,
};
const request = (path = "", body = input, method = "POST") =>
  new Request(`https://test/v1/cloud/runs${path}`, {
    method,
    headers: { "content-type": "application/json", "idempotency-key": id },
    ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
  });

test("default flags deny before auth, database or sandbox access", async () => {
  const response = await handleAPI(
    request(),
    { ...env, CLOUD_AGENTS_ENABLED: "0" },
    {
      authenticate() {
        throw Error("must not authenticate");
      },
    },
  );
  assert.equal(response.status, 404);
});
test("private allowlist denies a signed-in outsider", async () => {
  const r = await handleAPI(request(), env, { authenticate: () => id });
  assert.equal(r.status, 403);
});
test("start reserves once and sends encrypted credentials to durable initialization", async () => {
  let config, encrypted;
  const response = await handleAPI(request(), env, {
    authenticate: () => uid,
    db: {
      call(action, owner, runId, data) {
        assert.equal(action, "reserve");
        assert.equal(owner, uid);
        assert.equal(runId, id);
        config = data;
        return { ...data, user_id: uid, status: "queued" };
      },
    },
    runStub: () => ({
      initialize(owner, run, ciphertext) {
        assert.equal(owner, uid);
        encrypted = ciphertext;
      },
    }),
  });
  assert.equal(response.status, 202);
  assert.equal(config.result_branch, `gyro/cloud/${id}`);
  assert.equal(config.cap_seconds, 3600);
  assert.equal(config.idle_seconds, 600);
  assert.equal(JSON.stringify(config).includes(credentials.apiKey), false);
  assert.equal(JSON.stringify(encrypted).includes(credentials.apiKey), false);
  assert.deepEqual(await unseal(encrypted, key, id), credentials);
});
test("ciphertext is bound to its run and authenticated against tampering", async () => {
  const value = await seal(credentials, key, id);
  await assert.rejects(unseal(value, key, uid));
  await assert.rejects(
    unseal({ ...value, data: value.data.slice(0, -3) + "AAA" }, key, id),
  );
});
test("a supplied key in the task cannot leak through the persisted run or API response", () => {
  const result = startInput(
    { ...input, task: `Use ${credentials.apiKey} and ${credentials.gitToken}` },
    id,
  );
  const stored = JSON.stringify(result.config);
  assert.equal(stored.includes(credentials.apiKey), false);
  assert.equal(stored.includes(credentials.gitToken), false);
  assert.match(stored, /REDACTED/);
});
test("OAuth tokens, shell-shaped branches, embedded credentials and excessive caps are rejected", () => {
  for (const change of [
    { credentials: { ...credentials, apiKey: "sk-ant-oat-" + "a".repeat(30) } },
    { branch: "--upload-pack=evil" },
    { branch: "main; touch /tmp/x" },
    { branch: "a/../b" },
    { repo: "https://token@github.com/a/b" },
    { repo: "https://github.com/a/b?token=x" },
    { capSeconds: 3601 },
    { capSeconds: 0 },
    { idleSeconds: 601 },
    { task: "" },
    { authMode: "subscription" },
  ])
    assert.throws(() => startInput({ ...input, ...change }, id));
});
test("request and stream errors never echo credentials or upstream failures", async () => {
  const response = await handleAPI(request(), env, {
    authenticate: () => uid,
    db: {
      call() {
        throw Error(credentials.apiKey);
      },
    },
  });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "internal_error" });
  const huge = new Request("https://test/v1/cloud/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "x".repeat(70000),
  });
  assert.equal(
    (await handleAPI(huge, env, { authenticate: () => uid })).status,
    413,
  );
});
test("logs check Postgres ownership before looking up the run object", async () => {
  const r = await handleAPI(request(`/${id}/logs`, null, "GET"), env, {
    authenticate: () => uid,
    db: {
      call() {
        throw Error("foreign run");
      },
    },
    runStub() {
      throw Error("must not touch run");
    },
  });
  assert.equal(r.status, 500);
});
test("SSE replay preserves IDs and reports truncation without credentials in URLs", async () => {
  const r = await handleAPI(request(`/${id}/logs?after=4`, null, "GET"), env, {
    authenticate: () => uid,
    db: {
      call() {
        return { status: "running" };
      },
    },
    runStub: () => ({
      logs(owner, after) {
        assert.equal(owner, uid);
        assert.equal(after, 4);
        return {
          cursor: 8,
          truncated: true,
          events: [{ id: 8, text: "working" }],
        };
      },
    }),
  });
  const body = await r.text();
  assert.match(body, /id: 8/);
  assert.match(body, /"truncated":true/);
  assert.match(body, /retry: 2000/);
});
test("Supabase issuer verification is required after validating JWT shape", async () => {
  const claims = {
    sub: uid,
    session_id: id,
    iss: `${env.SUPABASE_URL}/auth/v1`,
    aud: "authenticated",
    role: "authenticated",
    is_anonymous: false,
    exp: Math.floor(Date.now() / 1000) + 100,
  };
  const token = `e30.${btoa(JSON.stringify(claims))}.signature`;
  const req = new Request("https://test", {
    headers: { authorization: `Bearer ${token}` },
  });
  await assert.rejects(
    authenticate(req, env, async () => new Response(null, { status: 401 })),
  );
  assert.equal(
    await authenticate(req, env, async () =>
      Response.json({
        id: uid,
        is_anonymous: false,
        email_confirmed_at: "now",
      }),
    ),
    uid,
  );
  await assert.rejects(
    authenticate(req, env, async () =>
      Response.json({ id, is_anonymous: false, email_confirmed_at: "now" }),
    ),
  );
});
test("redaction covers the existing core token families and literal supplied secrets", () => {
  const examples = [
    credentials.apiKey,
    credentials.gitToken,
    "AKIA" + "A".repeat(16),
    "AIza" + "a".repeat(35),
    "xoxb-" + "a".repeat(20),
    "xai-" + "a".repeat(20),
    "eyJ" + "a".repeat(9) + "." + "b".repeat(10) + "." + "c".repeat(10),
    '"password": "private-value"',
    "Bearer abcdefghijklmnop",
    "unique-private-value",
  ];
  const output = redact(examples.join("\n"), ["unique-private-value"]);
  for (const value of examples)
    assert.equal(output.includes(value), false, value);
});
const pkt = (text) =>
  (Buffer.byteLength(text) + 4).toString(16).padStart(4, "0") + text;
const command = (branch) =>
  `${"0".repeat(40)} ${"a".repeat(40)} refs/heads/${branch}\0 report-status\n`;
const stream = (text) => new Blob([text]).stream();
test("Git push accepts the generated branch with streamed pack data", async () => {
  const text = pkt(command(`gyro/cloud/${id}`)) + "0000PACK-data";
  const result = await checkedPushBody(stream(text), `gyro/cloud/${id}`);
  assert.equal(await new Response(result).text(), text);
});
test("Git push rejects main, branch deletion, and a hidden second ref command", async () => {
  for (const text of [
    pkt(command("main")) + "0000PACK",
    pkt(command(`gyro/cloud/${id}`)) + pkt(command("main")) + "0000PACK",
    pkt(`${"a".repeat(40)} ${"0".repeat(40)} refs/heads/gyro/cloud/${id}\n`) +
      "0000",
  ])
    await assert.rejects(checkedPushBody(stream(text), `gyro/cloud/${id}`));
});
