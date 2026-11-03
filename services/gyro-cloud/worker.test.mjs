import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "./worker.mjs";

test("authenticated transfers isolate accounts and preserve the last committed backup", async (t) => {
  const algorithm = { name: "ECDSA", namedCurve: "P-256" };
  const keys = await crypto.subtle.generateKey(algorithm, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
  t.mock.method(globalThis, "fetch", async () => Response.json({ keys: [{ ...jwk, kid: "test" }] }));
  t.mock.method(console, "info", () => {});
  const issuer = "https://identity.example/";
  const audience = "authenticated";
  const origin = "https://cloud.example";
  async function token(sub, overrides = {}) {
    const json = value => Buffer.from(JSON.stringify(value)).toString("base64url");
    const claims = { iss: issuer, sub, aud: audience, role: "authenticated", is_anonymous: false, session_id: crypto.randomUUID(), exp: Date.now() / 1000 + 120, ...overrides };
    const message = [json({ alg: "ES256", kid: "test" }), json(claims)].join(".");
    const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, Buffer.from(message));
    return message + "." + Buffer.from(signature).toString("base64url");
  }

  const objects = new Map();
  const env = {
    OIDC_ISSUER: issuer,
    OIDC_AUDIENCE: audience,
    OIDC_JWKS_URL: issuer + "jwks",
    CHATS: {
      async head(key) { return objects.get(key); },
      async get(key) { return objects.get(key); },
      async delete(key) { objects.delete(key); },
      async list({ prefix, cursor }) {
        const matches = Array.from(objects.values()).filter(object => object.key.startsWith(prefix));
        const start = Number(cursor ?? 0);
        return { objects: matches.slice(start, start + 1), truncated: matches.length > start + 1, cursor: String(start + 1) };
      },
      async put(key, body, options) {
        const previous = objects.get(key);
        if (options.onlyIf.get("If-Match") && options.onlyIf.get("If-Match") !== previous?.httpEtag) return null;
        if (options.onlyIf.get("If-None-Match") === "*" && previous) return null;
        const hash = Buffer.from(await crypto.subtle.digest("SHA-256", body)).toString("hex");
        if (options.sha256) assert.equal(options.sha256, hash);
        const value = {
          key, body, size: body.byteLength, uploaded: new Date(),
          httpEtag: '"' + hash.slice(0, 32) + '"', customMetadata: options.customMetadata,
        };
        objects.set(key, value);
        return value;
      },
    },
  };
  const aliceId = crypto.randomUUID();
  const alice = await token(aliceId);
  const bob = await token(crypto.randomUUID());
  const id = "31799fb3-54db-43d8-9e3e-900963405980";
  const path = "/v1/chats/" + id;
  const body = new Uint8Array(96).fill(1);
  const updated = new Uint8Array(96).fill(2);
  updated[0] = 1;
  const call = (credential, method, route, options = {}) => worker.fetch(new Request(origin + route, {
    method, ...options, headers: { ...options.headers, Authorization: "Bearer " + credential },
  }), env);
  const upload = (credential, payload, condition, length = payload.byteLength, route = path) => call(credential, "PUT", route, {
    body: payload, headers: { ...condition, "Content-Length": String(length), "X-Gyro-Title": "encrypted" },
  });
  assert.equal((await call(await token(aliceId, { aud: "wrong" }), "GET", path)).status, 401);
  assert.equal((await call(await token(aliceId, { exp: 0 }), "GET", path)).status, 401);
  assert.equal((await call(await token(aliceId, { is_anonymous: true }), "GET", path)).status, 401);
  const tampered = alice.slice(0, alice.lastIndexOf(".") + 1) + "AA";
  assert.equal((await call(tampered, "GET", path)).status, 401);

  const verifier = new Uint8Array(58).fill(1);
  assert.equal((await upload(alice, verifier, {}, 58, "/v1/key-check")).status, 201);
  assert.equal((await upload(alice, verifier, {}, 58, "/v1/key-check")).status, 412);
  assert.equal((await call(bob, "GET", "/v1/key-check")).status, 404);

  const initial = await (await upload(alice, body, { "If-None-Match": "*" })).json();
  assert.equal((await upload(alice, body, { "If-None-Match": "*" })).status, 200);
  assert.equal((await upload(alice, updated, { "If-None-Match": "*" })).status, 412);
  assert.equal((await upload(alice, updated, { "If-Match": initial.etag }, 100)).status, 400);
  assert.equal((await upload(alice, updated, { "If-Match": initial.etag }, 16 * 1024 * 1024 + 1)).status, 413);
  assert.equal((await call(alice, "HEAD", path)).headers.get("ETag"), initial.etag);

  assert.equal((await call(bob, "GET", path)).status, 404);
  assert.deepEqual((await (await call(bob, "GET", "/v1/chats")).json()).items, []);
  assert.equal((await upload(bob, updated, { "If-Match": initial.etag })).status, 412);
  assert.equal((await call(bob, "DELETE", path)).status, 204);
  const downloaded = await call(alice, "GET", path);
  assert.deepEqual(new Uint8Array(await downloaded.arrayBuffer()), body);

  const replacement = await (await upload(alice, updated, { "If-Match": initial.etag })).json();
  assert.notEqual(replacement.etag, initial.etag);
  assert.equal((await upload(alice, updated, { "If-Match": initial.etag })).status, 200);
  assert.equal((await upload(alice, body, { "If-Match": initial.etag })).status, 412);
  assert.equal(objects.size, 2); // One chat object plus the account key check.
  assert.deepEqual(new Uint8Array(await (await call(alice, "GET", path)).arrayBuffer()), updated);

  const secondPath = path.replace("31799fb3", "41799fb3");
  assert.equal((await upload(alice, body, { "If-None-Match": "*" }, body.byteLength, secondPath)).status, 200);
  const page = await (await call(alice, "GET", "/v1/chats")).json();
  assert.deepEqual(page.items.map(item => item.id), [id]);
  const next = await (await call(alice, "GET", "/v1/chats?cursor=" + page.cursor)).json();
  assert.deepEqual(next.items.map(item => item.id), [secondPath.split("/").at(-1)]);

  assert.equal((await call(alice, "DELETE", path)).status, 204);
  assert.equal((await call(alice, "GET", path)).status, 404);
});


test("legacy staging tokens require successful validation by the pinned issuer", async (t) => {
  const issuer = "https://identity.example/auth/v1";
  const subject = crypto.randomUUID();
  const claims = {
    iss: issuer, sub: subject, aud: "authenticated", role: "authenticated",
    is_anonymous: false, session_id: crypto.randomUUID(), exp: Date.now() / 1000 + 120,
  };
  const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  const bearer = "Bearer " + [encode({ alg: "HS256" }), encode(claims), "c2ln"].join(".");
  let verified = false;
  let userId = subject;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, issuer + "/user");
    assert.equal(options.headers.Authorization, bearer);
    assert.equal(options.headers.apikey, "test-publishable-key");
    return verified
      ? Response.json({ id: userId, role: "authenticated", is_anonymous: false, email_confirmed_at: "2026-11-03T00:00:00Z" })
      : new Response(null, { status: 401 });
  });
  t.mock.method(console, "info", () => {});
  const request = () => new Request("https://cloud.example/v1/account", { headers: { Authorization: bearer } });
  const env = { OIDC_ISSUER: issuer, OIDC_AUDIENCE: "authenticated", SUPABASE_PUBLISHABLE_KEY: "test-publishable-key" };
  assert.equal((await worker.fetch(request(), env)).status, 401);
  verified = true;
  const accepted = await worker.fetch(request(), env);
  assert.equal(accepted.status, 200);
  assert.match((await accepted.json()).account, /^[0-9a-f]{64}$/);
  userId = crypto.randomUUID();
  assert.equal((await worker.fetch(request(), env)).status, 401);
});
